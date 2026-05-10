/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./webview/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Map to VS Code theme variables so the UI follows the user's theme.
        vscode: {
          fg: "var(--vscode-foreground)",
          bg: "var(--vscode-editor-background)",
          panel: "var(--vscode-sideBar-background)",
          border: "var(--vscode-panel-border)",
          accent: "var(--vscode-focusBorder)",
          muted: "var(--vscode-descriptionForeground)",
          button: "var(--vscode-button-background)",
          buttonFg: "var(--vscode-button-foreground)",
          buttonHover: "var(--vscode-button-hoverBackground)",
          inputBg: "var(--vscode-input-background)",
          inputBorder: "var(--vscode-input-border)",
          listHover: "var(--vscode-list-hoverBackground)",
          listActive: "var(--vscode-list-activeSelectionBackground)",
        },
      },
      fontFamily: {
        mono: ["var(--vscode-editor-font-family)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
