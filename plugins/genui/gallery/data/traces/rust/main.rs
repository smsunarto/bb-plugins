// Reads the worker count from the environment.
use std::env;

fn workers() -> usize {
    let raw = env::var("WORKERS").unwrap_or_else(|_| "four".to_string());
    raw.parse().expect("WORKERS must be a whole number")
}

fn main() {
    println!("starting {} workers", workers());
}
