import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// COMPONENTS
import Accordion from "./Accordion/";
import Tabs from "./Tabs/";
import Pagination from "./Pagination/";
import ProgressBar from "./ProgressBar/";
import TooltipsPopovers from "./TooltipsPopovers/";
import Modal from "./Modal/";
import Notifications from "./Notifications/";
import CountUp from "./CountUp/";
import GuidedTours from "./GuidedTours/";
import Carousel from "./Carousel/";
import Calendar from "./Calendar/";
import Maps from "./Maps/";
import ImageCropper from "./ImageCropper/";
import StickyElements from "./StickyElements/";
import ScrollableElements from "./ScrollableElements/";
import TreeView from "./TreeView/";
import Ratings from "./Ratings/";
import BlockLoading from "./BlockLoading/";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Components = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="accordion" replace />} />
        <Route path="accordion" element={<Accordion />} />
        <Route path="tabs" element={<Tabs />} />
        <Route path="pagination" element={<Pagination />} />
        <Route path="progress-bar" element={<ProgressBar />} />
        <Route path="tooltips-popovers" element={<TooltipsPopovers />} />
        <Route path="modals" element={<Modal />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="count-up" element={<CountUp />} />
        <Route path="guided-tours" element={<GuidedTours />} />
        <Route path="carousel" element={<Carousel />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="maps" element={<Maps />} />
        <Route path="image-crop" element={<ImageCropper />} />
        <Route path="sticky-elements" element={<StickyElements />} />
        <Route path="scrollable-elements" element={<ScrollableElements />} />
        <Route path="tree-view" element={<TreeView />} />
        <Route path="rating" element={<Ratings />} />
        <Route path="block-ui" element={<BlockLoading />} />
        /* Removed catch-all route to prevent infinite redirects */
      </Routes>
    </Fragment>
  );
};

export default Components;
