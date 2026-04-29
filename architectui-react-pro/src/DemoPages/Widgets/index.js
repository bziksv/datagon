import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// Widgets
import ChartBoxes from "./ChartBoxes/";
import ChartBoxes2 from "./ChartBoxes2/";
import ChartBoxes3 from "./ChartBoxes3/";
import ProfileBoxes from "./ProfileBoxes/";
import ContentBoxes from "./ContentBoxes/";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Widgets = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="chart-boxes-1" replace />} />
        <Route path="chart-boxes-1" element={<ChartBoxes />} />
        <Route path="chart-boxes-2" element={<ChartBoxes2 />} />
        <Route path="chart-boxes-3" element={<ChartBoxes3 />} />
        <Route path="profile-boxes" element={<ProfileBoxes />} />
        <Route path="content-boxes" element={<ContentBoxes />} />
        {/* Removed catch-all route to prevent infinite redirects */}
      </Routes>
    </Fragment>
  );
};

export default Widgets;
