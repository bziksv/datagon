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
// import FormValidationExample from "./Examples/FormValidation";
import FormsFeedback from "./Examples/Feedback";

class FormElementsValidation extends React.Component {
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
              <PageTitle heading="Form Validation"
                subheading="Inline validation is very easy to implement using the ArchitectUI Framework."
                icon="lnr-picture text-danger"/>
              <div className="tabs-animation-wrap">
                <Nav tabs>
                  <NavItem>
                    <NavLink
                      className={classnames({ active: this.state.activeTab === '1' })}
                      onClick={() => { this.toggle('1'); }}
                    >
                      Feedback
                    </NavLink>
                  </NavItem>
                </Nav>
                <TabContent activeTab={this.state.activeTab}>
                  <TabPane tabId="1">
                    <FormsFeedback />
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

export default FormElementsValidation;
