// 发布版不要附带控制台黑框；调试版保留输出，方便看 panic 与日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yijing_lib::run();
}
