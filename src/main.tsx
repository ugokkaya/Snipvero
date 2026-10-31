import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { About } from "./About";
import { App } from "./App";
import { Overlay } from "./overlay/Overlay";
import { routeFor } from "./route";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

const route = routeFor(getCurrentWindow().label);
document.documentElement.classList.add(`${route.view}-root`);

createRoot(root).render(
  <StrictMode>
    {route.view === "overlay" ? (
      <Overlay index={route.index} />
    ) : route.view === "about" ? (
      <About />
    ) : (
      <App />
    )}
  </StrictMode>,
);
