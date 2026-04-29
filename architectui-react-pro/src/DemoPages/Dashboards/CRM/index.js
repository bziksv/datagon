import React, { Component, Fragment } from "react";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";

import PageTitle from "../../../Layout/AppMain/PageTitle";

import {
  ButtonGroup,
  Button
} from "reactstrap";

import CRMDashboard1 from "./Examples/Variation1";
import CRMDashboard2 from "./Examples/Variation2";

export default class CRMDashboard extends Component {
  constructor(props) {
    super(props);
    this.state = {
      activeTab: '1'
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
              <PageTitle heading="CRM Dashboard"
                subheading="Advanced dashboard with powerful features and interactive components."
                icon="pe-7s-graph icon-gradient bg-ripe-malin"/>
              
              <div className="mb-3">
                <ButtonGroup>
                  <Button
                    color={this.state.activeTab === '1' ? 'primary' : 'light'}
                    onClick={() => this.toggle('1')}
                    active={this.state.activeTab === '1'}
                  >
                    Variation 1
                  </Button>
                  <Button
                    color={this.state.activeTab === '2' ? 'primary' : 'light'}
                    onClick={() => this.toggle('2')}
                    active={this.state.activeTab === '2'}
                  >
                    Variation 2
                  </Button>
                </ButtonGroup>
              </div>

              <div className="tab-content">
                {this.state.activeTab === '1' && (
                  <div className="tab-pane active" style={{marginLeft: 0, paddingLeft: 0}}>
                    <CRMDashboard1 />
                  </div>
                )}
                {this.state.activeTab === '2' && (
                  <div className="tab-pane active" style={{marginLeft: 0, paddingLeft: 0}}>
                    <CRMDashboard2 />
                  </div>
                )}
              </div>
            </div>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}
