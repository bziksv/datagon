import React, { Fragment } from "react";
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";
import PageTitle from "../../../Layout/AppMain/PageTitle";

import Variation1 from "./Examples/Variation1";

export default function SalesDashboard() {
  return (
    <Fragment>
      <TransitionGroup>
        <CSSTransition
          component="div"
          classNames="TabsAnimation"
          appear={true}
          timeout={1500}
          enter={false}
          exit={false}
        >
          <div>
            <PageTitle
              heading="Sales Dashboard"
              subheading="This is an example dashboard created using build-in elements and components."
              icon="pe-7s-cash icon-gradient bg-sunny-morning"
            />
            <Variation1 />
          </div>
        </CSSTransition>
      </TransitionGroup>
    </Fragment>
  );
}
