// Applied synchronously (before CSS/first paint) so opening this page as a
// full-tab dashboard (?mode=dashboard) doesn't flash the docked layout first.
if (new URLSearchParams(location.search).get("mode") === "dashboard") {
  document.documentElement.classList.add("dashboard-mode");
}
