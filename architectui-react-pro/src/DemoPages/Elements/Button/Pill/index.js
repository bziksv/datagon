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
import ButtonsPillSolid from "./Examples/Solid";
import ButtonsPillOutline from "./Examples/Outline";
import ButtonsPillOutline2x from "./Examples/Outline2x";
import ButtonsPillDashed from "./Examples/Dashed";
import ButtonsPillGradients from "./Examples/Gradients";

export default class ButtonsPill extends React.Component {
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
              <PageTitle
                heading="Pills Buttons"
                subheading="The pills buttons from ArchitectUI Framework have 100% rounded corners."
                icon="pe-7s-bluetooth icon-gradient bg-deep-blue" />
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

                  <ButtonsPillSolid />
                                  </TabPane>
                  <TabPane tabId="2">

                  <ButtonsPillOutline />
                                  </TabPane>
                  <TabPane tabId="3">

                  <ButtonsPillOutline2x />
                                  </TabPane>
                  <TabPane tabId="4">

                  <ButtonsPillDashed />
                                  </TabPane>
                  <TabPane tabId="5">

                  <ButtonsPillGradients />
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
