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

import FlagIconsExample from "./Examples/FlagIcons";
import FontAwesomeIconsExample from "./Examples/FontAwesome";
import Pe7IconsExample from "./Examples/Pe7Icons";
import LinearIconsExample from "./Examples/LinearIcons";
import IonIconsExample from "./Examples/IonIcons";

export default class IconsExamples extends React.Component {
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
              <PageTitle heading="Icons"
                subheading="Wide icons selection including from flag icons to FontAwesome and other icons libraries."
                icon="pe-7s-phone icon-gradient bg-night-fade"/>
              <div className="tabs-animation-wrap">
                <Nav tabs>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '1' })}
                      onClick={() => { this.toggle('1'); }}
                    >
                      Pe7 Icons
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '2' })}
                      onClick={() => { this.toggle('2'); }}
                    >
                      FontAwesome
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '3' })}
                      onClick={() => { this.toggle('3'); }}
                    >
                      Linear Icons
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '4' })}
                      onClick={() => { this.toggle('4'); }}
                    >
                      Ion Icons
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '5' })}
                      onClick={() => { this.toggle('5'); }}
                    >
                      Flag Icons
                    </NavLink>
                  </NavItem>
                </Nav>
                <TabContent activeTab={this.state.activeTab}>
                  <TabPane tabId="1">

                  <Pe7IconsExample />
                                  </TabPane>
                  <TabPane tabId="2">

                  <FontAwesomeIconsExample />
                                  </TabPane>
                  <TabPane tabId="3">

                  <LinearIconsExample />
                                  </TabPane>
                  <TabPane tabId="4">

                  <IonIconsExample />
                                  </TabPane>
                  <TabPane tabId="5">

                  <FlagIconsExample />
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
