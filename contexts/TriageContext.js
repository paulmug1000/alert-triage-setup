import React, { createContext, useContext } from "react";

const TriageContext = createContext();

export const useTriage = () => useContext(TriageContext);

export const TriageProvider = ({ value, children }) => (
  <TriageContext.Provider value={value}>
    {children}
  </TriageContext.Provider>
);