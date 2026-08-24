import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (navigator.userAgent.includes("Macintosh")) {
  document.documentElement.classList.add("platform-macos");
}

const savedTheme = localStorage.getItem("ants-nest-theme");
const initialTheme = savedTheme === "light" || savedTheme === "dark"
  ? savedTheme
  : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = initialTheme;
document.documentElement.style.colorScheme = initialTheme;
window.antsNest.setTitleBarTheme(initialTheme);

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
