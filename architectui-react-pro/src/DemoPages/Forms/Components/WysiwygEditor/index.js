import React, { Fragment } from "react";

import PageTitle from "../../../../Layout/AppMain/PageTitle";

// Examples
import FormSimpleRichTextEditor from "./Examples/SimpleRichTextEditor";

export default class FormWysiwygEditor extends React.Component {
  render() {
    return (
      <Fragment>
        <PageTitle heading="WYSIWYG Editors"
          subheading="React 19-compatible rich text editors with no licensing restrictions."
          icon="pe-7s-like icon-gradient bg-love-kiss"/>
        <div className="mb-3">
          <FormSimpleRichTextEditor />
        </div>
      </Fragment>
    );
  }
}
