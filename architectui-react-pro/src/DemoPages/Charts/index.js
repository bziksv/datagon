import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// Charts
import ChartJs from "./ChartJs/";
import ApexCharts from "./ApexCharts/";
import Sparklines1 from "./Sparklines1/";
import Sparklines2 from "./Sparklines2/";
import Gauges from "./Gauges/";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Charts = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="chartjs" replace />} />
        <Route path="chartjs" element={<ChartJs />} />
        <Route path="apex-charts" element={<ApexCharts />} />
        <Route path="sparklines-1" element={<Sparklines1 />} />
        <Route path="sparklines-2" element={<Sparklines2 />} />
        <Route path="gauges" element={<Gauges />} />
        {/* Removed catch-all route to prevent infinite redirects */}
      </Routes>
    </Fragment>
  );
};

export default Charts;
