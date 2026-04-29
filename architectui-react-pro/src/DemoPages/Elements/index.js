import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// Icons
import { library } from "@fortawesome/fontawesome-svg-core";
import {
  faAngleLeft,
  faAngleRight,
  faArrowRight,
  faCaretUp,
  faChevronDown,
  faChevronUp,
  faChevronRight,
  faEye,
  faEyeSlash,
  faAngleDown,
  faAngleUp,
  faPlusCircle,
  faMinusCircle,
  faTimesCircle,
  faCheckCircle,
  faExclamationCircle,
  faInfoCircle,
  faQuestionCircle,
  faSearch,
  faTimes,
  faPlus,
  faMinus,
  faCheck,
  faEdit,
  faSave,
  faTrashAlt,
  faUpload,
  faDownload,
  faSpinner,
  faCircleNotch,
  faRedoAlt,
  faUndoAlt,
  faFilter,
  faSort,
  faSortUp,
  faSortDown,
  faCog,
  faEllipsisV,
  faEllipsisH,
  faExpand,
  faCompress,
  faExternalLinkAlt,
  faLink,
  faUnlink,
  faCopy,
  faCut,
  faPaste,
  faHome,
  faUser,
  faUsers,
  faUserCircle,
  faCalendar,
  faCalendarAlt,
  faClock,
  faStopwatch,
  faMapMarkerAlt,
  faGlobe,
  faPhone,
  faEnvelope,
  faComments,
  faComment,
  faThumbsUp,
  faThumbsDown,
  faHeart,
  faStar,
  faStarHalf,
  faFlag,
  faBookmark,
  faTag,
  faTags,
  faFile,
  faFileAlt,
  faFolder,
  faFolderOpen,
  faImage,
  faImages,
  faVideo,
  faMusic,
  faVolumeUp,
  faVolumeDown,
  faVolumeMute,
  faPlay,
  faPause,
  faStop,
  faForward,
  faBackward,
  faStepForward,
  faStepBackward,
  faFastForward,
  faFastBackward,
  faShoppingCart,
  faShoppingBag,
  faCreditCard,
  faMoneyBillAlt,
  faCoins,
  faReceipt,
  faPercentage,
} from "@fortawesome/free-solid-svg-icons";

library.add(
  faAngleLeft,
  faAngleRight,
  faArrowRight,
  faCaretUp,
  faChevronDown,
  faChevronUp,
  faChevronRight,
  faEye,
  faEyeSlash,
  faAngleDown,
  faAngleUp,
  faPlusCircle,
  faMinusCircle,
  faTimesCircle,
  faCheckCircle,
  faExclamationCircle,
  faInfoCircle,
  faQuestionCircle,
  faSearch,
  faTimes,
  faPlus,
  faMinus,
  faCheck,
  faEdit,
  faSave,
  faTrashAlt,
  faUpload,
  faDownload,
  faSpinner,
  faCircleNotch,
  faRedoAlt,
  faUndoAlt,
  faFilter,
  faSort,
  faSortUp,
  faSortDown,
  faCog,
  faEllipsisV,
  faEllipsisH,
  faExpand,
  faCompress,
  faExternalLinkAlt,
  faLink,
  faUnlink,
  faCopy,
  faCut,
  faPaste,
  faHome,
  faUser,
  faUsers,
  faUserCircle,
  faCalendar,
  faCalendarAlt,
  faClock,
  faStopwatch,
  faMapMarkerAlt,
  faGlobe,
  faPhone,
  faEnvelope,
  faComments,
  faComment,
  faThumbsUp,
  faThumbsDown,
  faHeart,
  faStar,
  faStarHalf,
  faFlag,
  faBookmark,
  faTag,
  faTags,
  faFile,
  faFileAlt,
  faFolder,
  faFolderOpen,
  faImage,
  faImages,
  faVideo,
  faMusic,
  faVolumeUp,
  faVolumeDown,
  faVolumeMute,
  faPlay,
  faPause,
  faStop,
  faForward,
  faBackward,
  faStepForward,
  faStepBackward,
  faFastForward,
  faFastBackward,
  faShoppingCart,
  faShoppingBag,
  faCreditCard,
  faMoneyBillAlt,
  faCoins,
  faReceipt,
  faPercentage
);

// Buttons
import ButtonsStandard from "./Button/Standard/";
import ButtonsSquare from "./Button/Square/";
import ButtonsPill from "./Button/Pill/";
import ButtonsShadow from "./Button/Shadow/";
import ButtonsIcons from "./Button/Icons/";

// Dropdowns
import DropdownExamples from "./Dropdowns/";

// Badges & Labels
import BadgesLabels from "./BadgesLabels/";

// Icons
import IconsExamples from "./Icons/";

// Cards
import CardsExamples from "./Cards/";

// Loaders
import LoadersExample from "./Loaders/";

// List Group
import ListGroupExample from "./ListGroup/";

// Timeline
import TimelineExample from "./Timeline/";

// Navs
import NavigationExample from "./Navs/";

// Screen Visibility Sensor
import ScreenVisibilityExamples from "./ScreenVisibility/";

// Utilities
import UtilitiesExamples from "./Utilities/";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Elements = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="buttons-standard" replace />} />
        
        {/* Buttons */}
        <Route path="buttons-standard" element={<ButtonsStandard />} />
        <Route path="buttons-square" element={<ButtonsSquare />} />
        <Route path="buttons-pills" element={<ButtonsPill />} />
        <Route path="buttons-shadow" element={<ButtonsShadow />} />
        <Route path="buttons-icons" element={<ButtonsIcons />} />

        {/* Dropdowns */}
        <Route path="dropdowns" element={<DropdownExamples />} />

        {/* Badges & Labels */}
        <Route path="badges-labels" element={<BadgesLabels />} />

        {/* Icons */}
        <Route path="icons" element={<IconsExamples />} />

        {/* Cards */}
        <Route path="cards" element={<CardsExamples />} />

        {/* Loaders */}
        <Route path="loaders" element={<LoadersExample />} />

        {/* List Group */}
        <Route path="list-group" element={<ListGroupExample />} />

        {/* Timeline */}
        <Route path="timelines" element={<TimelineExample />} />

        {/* Navs */}
        <Route path="navigation" element={<NavigationExample />} />

        {/* Screen Visibility */}
        <Route path="visibility-sensor" element={<ScreenVisibilityExamples />} />

        {/* Utilities */}
        <Route path="utilities" element={<UtilitiesExamples />} />
        
        {/* Fallback */}
        /* Removed catch-all route to prevent infinite redirects */
      </Routes>
    </Fragment>
  );
};

export default Elements;
