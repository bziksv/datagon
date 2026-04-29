import React, { Fragment } from "react";

import {
  Nav,
  NavItem,
  NavLink,
  TabContent,
  TabPane,
} from "reactstrap";
import classnames from "classnames";
import { CSSTransition, TransitionGroup } from "../../../../components/React19Transition";

import PageTitle from "../../../../Layout/AppMain/PageTitle";

// Examples
import ButtonsHorizontalIcons from "./Examples/Horizontal";
import ButtonsVerticalIcons from "./Examples/Vertical";

export default class ButtonsIcons extends React.Component {
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
            timeout={1500} enter={false}exit={false}>
            <div>  
              <PageTitle
                heading="Buttons with Icons"
                subheading="These buttons examples contain icons with or without labels attached."
                icon="pe-7s-hourglass icon-gradient bg-ripe-malin" />
              <div className="tabs-animation-wrap">
                <Nav tabs>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '1' })}
                      onClick={() => { this.toggle('1'); }}
                    >
                      Horizontal Icons
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '2' })}
                      onClick={() => { this.toggle('2'); }}
                    >
                      Vertical Icons
                    </NavLink>
                  </NavItem>
                </Nav>
                <TabContent activeTab={this.state.activeTab}>
                  <TabPane tabId="1">

                  <ButtonsHorizontalIcons />
                                  </TabPane>
                  <TabPane tabId="2">

                  <ButtonsVerticalIcons />
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
