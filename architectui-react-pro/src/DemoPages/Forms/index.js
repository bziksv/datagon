import React, { Fragment } from "react";
import { Route, Routes, Navigate } from "react-router-dom";

// Forms Components
import FormControls from "./Elements/Controls/";
import FormLayouts from "./Elements/Layouts/";
import FormValidation from "./Elements/Validation/";
import FormWizard from "./Elements/Wizard/";
import FormStickyHeaders from "./Elements/StickyHeaders/";

import FormDropdown from "./Components/Dropdown/";
import FormClipboard from "./Components/Clipboard/";
import FormToggleSwitch from "./Components/ToggleSwitch/";
import FormRangeSlider from "./Components/RangeSlider/";
import FormTypeahead from "./Components/Typeahead/";
import FormTextareaAutosize from "./Components/TextareaAutosize/";
import FormDatePicker from "./Components/DatePicker/";
import FormColorPicker from "./Components/ColorPicker/";
import FormDropZone from "./Components/DropZone/";
import FormInputMask from "./Components/InputMask/";
import FormMultiSelect from "./Components/MultiSelect/";
import FormWysiwygEditor from "./Components/WysiwygEditor/";
import FormNumberPicker from "./Components/NumberPicker/";

// Theme Options
import ThemeOptions from "../../Layout/ThemeOptions/";

const Forms = () => {
  return (
    <Fragment>
      <ThemeOptions />
      <Routes>
        <Route index element={<Navigate to="controls" replace />} />
        <Route path="controls" element={<FormControls />} />
        <Route path="layouts" element={<FormLayouts />} />
        <Route path="validation" element={<FormValidation />} />
        <Route path="wizard" element={<FormWizard />} />
        <Route path="sticky-headers" element={<FormStickyHeaders />} />
        <Route path="dropdown" element={<FormDropdown />} />
        <Route path="clipboard" element={<FormClipboard />} />
        <Route path="toggle-switch" element={<FormToggleSwitch />} />
        <Route path="range-slider" element={<FormRangeSlider />} />
        <Route path="typeahead" element={<FormTypeahead />} />
        <Route path="textarea-autosize" element={<FormTextareaAutosize />} />
        <Route path="date-picker" element={<FormDatePicker />} />
        <Route path="color-picker" element={<FormColorPicker />} />
        <Route path="dropzone" element={<FormDropZone />} />
        <Route path="input-mask" element={<FormInputMask />} />
        <Route path="input-selects" element={<FormMultiSelect />} />
        <Route path="wysiwyg-editor" element={<FormWysiwygEditor />} />
        <Route path="numberspinners" element={<FormNumberPicker />} />
        {/* Removed catch-all route to prevent infinite redirects */}
      </Routes>
    </Fragment>
  );
};

export default Forms;
