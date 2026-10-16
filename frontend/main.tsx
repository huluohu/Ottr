import React from "react";
import ReactDOM from "react-dom/client";
// i18n 初始化必须在 App 渲染前完成（词典加载同步，首帧即有译文）
import "./i18n";
import App from "./App";

// WebView 原生右键菜单屏蔽（2026-10-16 用户反馈）：Linux WebKitGTK 在无
// 自定义右键处理的区域弹出「Reload」等原生项——Reload 会整页重载前端，
// 运行态（终端视图/面板/弹框）尽失。全局 preventDefault 屏蔽原生菜单；
// 应用自定义右键菜单挂在具体元素上（事件先于 window 层触发），不受影响。
// 可编辑元素放行：输入框/文本域保留系统级复制粘贴菜单。
window.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable]")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
