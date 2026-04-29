import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// Tables
import RegularTables from "./RegularTables/";
import GridTables from "./GridTables/";
import DataTables from "./DataTables/";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Tables = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="regular-tables" replace />} />
        <Route path="regular-tables" element={<RegularTables />} />
        <Route path="grid-tables" element={<GridTables />} />
        <Route path="data-tables" element={<DataTables />} />
        {/* Removed catch-all route to prevent infinite redirects */}
      </Routes>
    </Fragment>
  );
};

export default Tables;
