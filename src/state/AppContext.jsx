// Shared App store context.
//
// App() builds one plain object holding every signal accessor, setter, derived
// memo and action that extracted view components need, then provides it here.
// Views call useApp() to read from it instead of receiving dozens of props.
//
// This keeps the giant App closure as the single source of truth while letting
// each view live in its own file.

import { createContext, useContext } from "solid-js";

const AppContext = createContext();

export function AppProvider(props) {
  return (
    <AppContext.Provider value={props.store}>
      {props.children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp() must be used within <AppProvider>");
  return ctx;
}
