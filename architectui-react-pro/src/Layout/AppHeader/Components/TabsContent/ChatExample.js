import React, { Component, Fragment } from "react";

import {
  VerticalTimeline,
  VerticalTimelineElement,
} from '../../../../components/React19Timeline';

import CustomScrollbar from "../../../../components/CustomScrollbar";

class TimelineEx extends Component {
  render() {
    return (
      <Fragment>
        <div className="scroll-area-sm">
          <CustomScrollbar>
            <div className="p-3">
              <VerticalTimeline className="vertical-time-simple vertical-without-time" layout="1-column">
                <VerticalTimelineElement className="vertical-timeline-item">
                  <h4 className="timeline-title">All Hands Meeting</h4>
                </VerticalTimelineElement>
                <VerticalTimelineElement className="vertical-timeline-item">
                  <p>
                    Another meeting today, at{" "}
                    <b className="text-danger">12:00 PM</b>
                  </p>
                </VerticalTimelineElement>
                <VerticalTimelineElement className="vertical-timeline-item">
                  <h4 className="timeline-title">
                    Build the production release
                  </h4>
                </VerticalTimelineElement>
                <VerticalTimelineElement className="vertical-timeline-item">
                  <h4 className="timeline-title">All Hands Meeting</h4>
                </VerticalTimelineElement>
                <VerticalTimelineElement className="vertical-timeline-item">
                  <h4 className="timeline-title text-success">
                    FontAwesome Icons
                  </h4>
                </VerticalTimelineElement>
                <VerticalTimelineElement className="vertical-timeline-item">
                  <h4 className="timeline-title">
                    Build the production release
                  </h4>
                </VerticalTimelineElement>
                <VerticalTimelineElement className="vertical-timeline-item">
                  <p>
                    Another meeting today, at{" "}
                    <b className="text-warning">12:00 PM</b>
                  </p>
                </VerticalTimelineElement>
              </VerticalTimeline>
            </div>
          </CustomScrollbar>
        </div>
      </Fragment>
    );
  }
}

export default TimelineEx;
