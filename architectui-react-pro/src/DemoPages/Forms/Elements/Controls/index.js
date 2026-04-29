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

import FormsDefault from "./Examples/FormBasic";
import InputGroups from "./Examples/InputGroup/InputGroups";

class FormElementsControls extends React.Component {
  constructor(props) {
    super(props);

    this.toggle = this.toggle.bind(this);
    this.state = {
      activeTab: '1'
    };
  }

  toggle(tab) {
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
              <PageTitle heading="Form Controls"
                subheading="Wide selection of forms controls, using the Bootstrap 5 code base, but built with React."
                icon="pe-7s-display1 icon-gradient bg-premium-dark"/>
              <div className="tabs-animation-wrap">
                <Nav tabs>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '1' })}
                      onClick={() => { this.toggle('1'); }}
                    >
                      Basic
                    </NavLink>
                  </NavItem>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '2' })}
                      onClick={() => { this.toggle('2'); }}
                    >
                      Input Groups
                    </NavLink>
                  </NavItem>
                </Nav>
                <TabContent activeTab={this.state.activeTab}>
                  <TabPane tabId="1">
                    <FormsDefault />
                  </TabPane>
                  <TabPane tabId="2">
                    <InputGroups />
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

export default FormElementsControls;
