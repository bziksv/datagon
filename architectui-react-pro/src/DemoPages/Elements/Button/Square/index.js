import React, {Fragment} from 'react';
import { CSSTransition, TransitionGroup } from "../../../../components/React19Transition";
import { Tabs, TabList, Tab, TabPanel } from 'react-tabs';
import 'react-tabs/style/react-tabs.css';

import PageTitle from '../../../../Layout/AppMain/PageTitle';

// Examples
import ButtonsSquareSolid from './Examples/Solid';
import ButtonsSquareOutline from './Examples/Outline';
import ButtonsSquareOutline2x from './Examples/Outline2x';
import ButtonsSquareDashed from './Examples/Dashed';
import ButtonsSquareGradients from './Examples/Gradients';

export default class ButtonsSquare extends React.Component {

    render() {

        return (
            <Fragment>
                <TransitionGroup>
                    <CSSTransition component="div" classNames="TabsAnimation" appear={true}
                        timeout={1500} enter={false} exit={false}>
                        <div>    
                            <PageTitle
                                heading="Square Buttons"
                                subheading="Wide selection of buttons with square corners. Their styling can be added to any button combination."
                                icon="pe-7s-car icon-gradient bg-mean-fruit"
                            />
                            <div className="tabs-animation-wrap">
                                <Tabs>
                                    <TabList className="nav nav-tabs">
                                        <Tab className="nav-item">
                                            <span className="nav-link">Solid</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Outline</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Outline 2x</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Dashed</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Gradients</span>
                                        </Tab>
                                    </TabList>
                                    <TabPanel>
                                        <ButtonsSquareSolid />
                                    </TabPanel>
                                    <TabPanel>
                                        <ButtonsSquareOutline />
                                    </TabPanel>
                                    <TabPanel>
                                        <ButtonsSquareOutline2x />
                                    </TabPanel>
                                    <TabPanel>
                                        <ButtonsSquareDashed />
                                    </TabPanel>
                                    <TabPanel>
                                        <ButtonsSquareGradients />
                                    </TabPanel>
                                </Tabs>
                            </div>
                        </div>
                    </CSSTransition>
                </TransitionGroup>
            </Fragment>
        );
    }
}
