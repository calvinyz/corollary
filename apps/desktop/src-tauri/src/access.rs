//! Which paths the webview may name. A path becomes usable only through a native dialog, a drop
//! onto the window or the command line, so script running in the webview can't reach the rest
//! of the disk through Corollary's commands. Opened projects are remembered, so recent projects
//! reopen without asking again.

use crate::sandbox::real;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_PROJECTS: usize = 100;

pub struct Access {
    store: PathBuf,
    projects: Mutex<Vec<PathBuf>>,
    chosen: Mutex<HashSet<PathBuf>>,
}

impl Access {
    /// `store` is a JSON list of project folders.
    pub fn load(store: PathBuf) -> Self {
        let projects = std::fs::read(&store).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Access { store, projects: Mutex::new(projects), chosen: Mutex::default() }
    }

    /// Records a path the user picked or dropped.
    pub fn choose(&self, path: &Path) {
        self.chosen.lock().unwrap().insert(real(path));
    }

    /// A path the user picked or dropped this session.
    pub fn chosen(&self, path: &str) -> Result<PathBuf, String> {
        let p = real(Path::new(path));
        if self.chosen.lock().unwrap().contains(&p) { Ok(p) } else { Err(format!("{path} wasn't chosen in Corollary")) }
    }

    /// An opened project's folder.
    pub fn project(&self, root: &str) -> Result<PathBuf, String> {
        let p = real(Path::new(root));
        if self.projects.lock().unwrap().contains(&p) { Ok(p) } else { Err(format!("{root} isn't an open project")) }
    }

    /// A folder that may be opened as a project: a known one, or one just chosen.
    pub fn openable(&self, path: &str) -> Result<PathBuf, String> {
        self.project(path).or_else(|_| self.chosen(path))
    }

    pub fn add_project(&self, root: &Path) {
        let root = real(root);
        let mut projects = self.projects.lock().unwrap();
        projects.retain(|p| *p != root);
        projects.insert(0, root);
        projects.truncate(MAX_PROJECTS);
        if let Some(dir) = self.store.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.store, serde_json::to_vec_pretty(&*projects).unwrap_or_default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_chosen_paths_and_opened_projects() {
        let dir = real(&std::env::temp_dir().join(format!("corollary-access-{}", std::process::id())));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("paper")).unwrap();
        let store = dir.join("projects.json");
        let paper = dir.join("paper").to_string_lossy().into_owned();

        let a = Access::load(store.clone());
        assert!(a.openable(&paper).is_err());
        assert!(a.chosen("/etc/passwd").is_err());
        a.choose(&dir.join("paper"));
        assert!(a.openable(&paper).is_ok());
        assert!(a.project(&paper).is_err(), "chosen isn't opened yet");
        a.add_project(&dir.join("paper"));
        assert!(a.project(&format!("{paper}/")).is_ok());

        let reloaded = Access::load(store);
        assert!(reloaded.project(&paper).is_ok(), "remembered across launches");
        assert!(reloaded.chosen(&paper).is_err(), "choices aren't");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
