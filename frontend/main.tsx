import React from "react";
import ReactDOM from "react-dom/client";
// i18n 初始化必须在 App 渲染前完成（词典加载同步，首帧即有译文）
import "./i18n";
import App from "./App";

if (import.meta.env.DEV) {
  import("./__ui-audit"); // TEMP：UI 验证驱动器，验证后删除
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
