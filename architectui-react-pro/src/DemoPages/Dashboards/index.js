import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// DASHBOARDS

import AnalyticsDashboard from "./Analytics/";
import SalesDashboard from "./Sales/";
import CommerceDashboard from "./Commerce/";
import CRMDashboard from "./CRM/";
import MinimalDashboard1 from "./Minimal/Variation1";
import MinimalDashboard2 from "./Minimal/Variation2";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Dashboards = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="analytics" replace />} />
        <Route path="analytics" element={<AnalyticsDashboard />} />
        <Route path="sales" element={<SalesDashboard />} />
        <Route path="commerce" element={<CommerceDashboard />} />
        <Route path="crm" element={<CRMDashboard />} />
        <Route path="minimal-dashboard-1" element={<MinimalDashboard1 />} />
        <Route path="minimal-dashboard-2" element={<MinimalDashboard2 />} />
      </Routes>
    </Fragment>
  );
};

export default Dashboards;
