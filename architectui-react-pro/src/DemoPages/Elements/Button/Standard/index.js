import React, { Component, Fragment } from "react";
import { CSSTransition } from "../../../../components/React19Transition";

import PageTitle from "../../../../Layout/AppMain/PageTitle";

import Solid from "./Examples/Solid";
import Outline from "./Examples/Outline";
import Outline2x from "./Examples/Outline2x";
import Gradients from "./Examples/Gradients";
import Dashed from "./Examples/Dashed";

export default class ButtonsStandard extends Component {
  constructor(props) {
    super(props);

    this.toggle = this.toggle.bind(this);
    this.state = {
      activeTab: "1",
    };
  }

  toggle(tab) {
    if (this.state.activeTab !== tab) {
      this.setState({
        activeTab: tab,
      });
    }
  }

  render() {
    return (
      <Fragment>
        <CSSTransition
          in={true}
          timeout={1500}
          classNames="TabsAnimation"
          appear={true}
          enter={true}
          exit={true}
        >
          <div>
            <PageTitle
              heading="Standard Buttons"
              subheading="Wide selection of buttons that feature different styles for backgrounds, borders and hover options!"
              icon="pe-7s-plane icon-gradient bg-tempting-azure"
            />
            <Solid />
            <Outline />
            <Outline2x />
            <Gradients />
            <Dashed />
          </div>
        </CSSTransition>
      </Fragment>
    );
  }
}
