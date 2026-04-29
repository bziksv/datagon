import React, { Fragment } from "react";

import {
  Nav,
  NavItem,
  NavLink,
  TabContent,
  TabPane,
} from "reactstrap";
import classnames from "classnames";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";

import PageTitle from "../../../Layout/AppMain/PageTitle";

// Examples
import BadgesExamples from "./Examples/badges";
import LabelsExamples from "./Examples/labels";
import AvatarsExamples from "./Examples/avatars";

export default class BadgesLabels extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      activeTab: "1"
    };
  }

  toggle = (tab) => {
    if (this.state.activeTab !== tab) {
      this.setState({
        activeTab: tab
      });
    }
  }

  render() {
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={1500} enter={false} exit={false}>
            <div>  
              <PageTitle heading="Badges & Labels"
                subheading="Badges and labels are used to offer extra small pieces of info for your content."
                icon="pe-7s-voicemail icon-gradient bg-arielle-smile"/>
              <div className="tabs-animation-wrap">
                <Nav tabs>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '1' })}
                      onClick={() => { this.toggle('1'); }}
                    >
                      Badges
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '2' })}
                      onClick={() => { this.toggle('2'); }}
                    >
                      Labels
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '3' })}
                      onClick={() => { this.toggle('3'); }}
                    >
                      Avatars
                    </NavLink>
                  </NavItem>
                </Nav>
                <TabContent activeTab={this.state.activeTab}>
                  <TabPane tabId="1">

                  <BadgesExamples />
                                  </TabPane>
                  <TabPane tabId="2">

                  <LabelsExamples />
                                  </TabPane>
                  <TabPane tabId="3">

                  <AvatarsExamples />
                                  </TabPane>
                </TabContent>
              </div>
            </div>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}
