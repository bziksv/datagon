import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// Applications
import Mailbox from "./Mailbox/";
import Chat from "./Chat/";
import FaqSection from "./FaqSection/";
import SplitLayout from "./SplitLayout/";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Applications = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="mailbox" replace />} />
        <Route path="mailbox" element={<Mailbox />} />
        <Route path="chat" element={<Chat />} />
        <Route path="faq-section" element={<FaqSection />} />
        <Route path="split-layout" element={<SplitLayout />} />
        {/* Removed catch-all route to prevent infinite redirects */}
      </Routes>
    </Fragment>
  );
};

export default Applications;
