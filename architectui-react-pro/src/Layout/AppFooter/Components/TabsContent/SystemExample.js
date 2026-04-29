import React, { Component, Fragment } from "react";
import CustomScrollbar from "../../../../components/CustomScrollbar";

class SysErrEx extends Component {
  render() {
    return (
      <Fragment>
        <div className="scroll-area-sm">
          <CustomScrollbar>
            <div className="no-results pb-0">
              <div className="sa-icon sa-success mt-0 animate">
                <span className="sa-line sa-tip animateSuccessTip" />
                <span className="sa-line sa-long animateSuccessLong" />
                <div className="sa-placeholder" />
                <div className="sa-fix" />
              </div>
              <div className="results-subtitle">All caught up!</div>
              <div className="results-title">There are no system errors!</div>
            </div>
          </CustomScrollbar>
        </div>
      </Fragment>
    );
  }
}

export default SysErrEx;
