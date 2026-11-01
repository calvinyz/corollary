//! Snapshots taken before AI edits. They live in a bare repository in the app's data folder
//! with the project as its work tree, so the project (and any Git repo of its own) is untouched.

use git2::{IndexAddOption, Oid, Repository, Signature};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Larger files (datasets, videos) are left out of snapshots.
const MAX_FILE_BYTES: u64 = 20 << 20;
const REF: &str = "refs/heads/checkpoints";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub message: String,
    pub time: i64,
}

pub fn store_dir(data_root: &Path, project_root: &Path) -> PathBuf {
    let build = crate::latex::build_dir(data_root, project_root);
    data_root.join("checkpoints").join(build.file_name().unwrap())
}

fn open(store: &Path, project_root: &Path) -> Result<Repository, git2::Error> {
    let repo = if store.join("HEAD").is_file() { Repository::open_bare(store)? } else { Repository::init_bare(store)? };
    repo.set_workdir(project_root, false)?;
    Ok(repo)
}

/// Returns the new checkpoint, or the latest one if nothing changed since.
pub fn create(store: &Path, project_root: &Path, message: &str) -> Result<String, git2::Error> {
    let repo = open(store, project_root)?;
    let mut index = repo.index()?;
    index.clear()?;
    let mut cb = |path: &Path, _: &[u8]| -> i32 {
        let size = project_root.join(path).metadata().map(|m| m.len()).unwrap_or(0);
        // 1 skips the file; 0 adds it.
        i32::from(size > MAX_FILE_BYTES)
    };
    index.add_all(["*"], IndexAddOption::DEFAULT, Some(&mut cb))?;
    let tree_id = index.write_tree()?;
    let parent = repo.find_reference(REF).ok().and_then(|r| r.peel_to_commit().ok());
    if let Some(p) = &parent
        && p.tree_id() == tree_id
    {
        return Ok(p.id().to_string());
    }
    let tree = repo.find_tree(tree_id)?;
    let sig = Signature::now("Corollary", "checkpoints@corollary.invalid")?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let id = repo.commit(Some(REF), &sig, &sig, message, &tree, &parents)?;
    Ok(id.to_string())
}

pub fn list(store: &Path, project_root: &Path, limit: usize) -> Result<Vec<Checkpoint>, git2::Error> {
    if !store.join("HEAD").is_file() {
        return Ok(vec![]);
    }
    let repo = open(store, project_root)?;
    let Ok(head) = repo.find_reference(REF).and_then(|r| r.peel_to_commit()) else { return Ok(vec![]) };
    let mut walk = repo.revwalk()?;
    walk.push(head.id())?;
    walk.take(limit)
        .map(|id| {
            let c = repo.find_commit(id?)?;
            Ok(Checkpoint { id: c.id().to_string(), message: c.message().unwrap_or("").to_string(), time: c.time().seconds() })
        })
        .collect()
}

/// Writes every file in the checkpoint back into the project. Files created since are kept.
pub fn restore(store: &Path, project_root: &Path, id: &str) -> Result<(), git2::Error> {
    create(store, project_root, "Before restoring a snapshot")?;
    let repo = open(store, project_root)?;
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let mut opts = git2::build::CheckoutBuilder::new();
    opts.force().update_index(false);
    repo.checkout_tree(commit.as_object(), Some(&mut opts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn snapshot_and_restore() {
        let base = std::env::temp_dir().join(format!("corollary-ckpt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let project = base.join("paper");
        fs::create_dir_all(project.join("sec")).unwrap();
        fs::write(project.join("main.tex"), "one").unwrap();
        fs::write(project.join("sec/a.tex"), "a").unwrap();
        let store = base.join("store");

        let first = create(&store, &project, "AI: rewrite").unwrap();
        assert_eq!(create(&store, &project, "again").unwrap(), first, "no change, no new checkpoint");
        assert!(!project.join(".git").exists(), "the project folder stays clean");

        fs::write(project.join("main.tex"), "two").unwrap();
        fs::write(project.join("new.tex"), "new").unwrap();
        restore(&store, &project, &first).unwrap();
        assert_eq!(fs::read_to_string(project.join("main.tex")).unwrap(), "one");
        assert!(project.join("new.tex").exists());

        let all = list(&store, &project, 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].message, "Before restoring a snapshot");
        fs::remove_dir_all(&base).unwrap();
    }
}
