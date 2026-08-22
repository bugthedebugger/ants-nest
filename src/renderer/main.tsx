import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.DEV && typeof window !== "undefined" && !window.antsNest) {
  await import("./dev-preview");
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
