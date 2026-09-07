use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf};

#[derive(Clone, Serialize, Deserialize)]
pub struct Program {
    pub exe: PathBuf,
    pub args: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub struct Config {
    pub cli: PathBuf,
    pub programs: HashMap<String, Program>,
}
