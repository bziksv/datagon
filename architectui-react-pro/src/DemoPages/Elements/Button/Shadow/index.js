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
import ButtonsShadowSolid from "./Examples/Solid";
import ButtonsShadowOutline from "./Examples/Outline";
import ButtonsShadowOutline2x from "./Examples/Outline2x";
import ButtonsShadowDashed from "./Examples/Dashed";
import ButtonsShadowGradients from "./Examples/Gradients";

export default class ButtonsShadow extends React.Component {
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
              <PageTitle heading="Shadow Buttons"
                subheading="These buttons are examples of buttons with drop shadows attached."
                icon="pe-7s-monitor icon-gradient bg-malibu-beach" />
              <div className="tabs-animation-wrap">
                <Nav tabs>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '1' })}
                      onClick={() => { this.toggle('1'); }}
                    >
                      Solid
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '2' })}
                      onClick={() => { this.toggle('2'); }}
                    >
                      Outline
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '3' })}
                      onClick={() => { this.toggle('3'); }}
                    >
                      Outline 2x
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '4' })}
                      onClick={() => { this.toggle('4'); }}
                    >
                      Dashed
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '5' })}
                      onClick={() => { this.toggle('5'); }}
                    >
                      Gradients
                    </NavLink>
                  </NavItem>
                </Nav>
                <TabContent activeTab={this.state.activeTab}>
                  <TabPane tabId="1">

                        <ButtonsShadowSolid />
                                      </TabPane>
                  <TabPane tabId="2">

                        <ButtonsShadowOutline />
                                      </TabPane>
                  <TabPane tabId="3">

                        <ButtonsShadowOutline2x />
                                      </TabPane>
                  <TabPane tabId="4">

                        <ButtonsShadowDashed />
                                      </TabPane>
                  <TabPane tabId="5">

                    <   ButtonsShadowGradients />
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
