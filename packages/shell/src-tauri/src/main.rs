//! Desktop entry point. Mobile frameworks load the library entry point directly.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hundredfold_shell_lib::run();
}
