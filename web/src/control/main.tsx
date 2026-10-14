import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/shared.css";
import "../styles/control.css";
import App from "./App";
import { Gate } from "./auth";

document.documentElement.style.setProperty("--ui", localStorage.getItem("pbs.ui") || "1");
createRoot(document.getElementById("root")!).render(<StrictMode><Gate><App /></Gate></StrictMode>);
