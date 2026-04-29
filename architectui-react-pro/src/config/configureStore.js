import { configureStore } from "@reduxjs/toolkit";
import ThemeOptionsReducer from "../reducers/ThemeOptions";

export default function configureReduxStore() {
  return configureStore({
    reducer: {
      ThemeOptions: ThemeOptionsReducer,
    },
    devTools: process.env.NODE_ENV !== 'production',
  });
}
