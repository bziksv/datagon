import React, {Fragment} from 'react';
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";
import { Tabs, TabList, Tab, TabPanel } from 'react-tabs';
import 'react-tabs/style/react-tabs.css';

import PageTitle from '../../../Layout/AppMain/PageTitle';

// Dropdown Examples
import DropdownStyles from './Examples/DropdownStyles';
import DropdownGridMenus from './Examples/DropdownGridMenus';

export default class DropdownExamples extends React.Component {

    render() {

        return (
            <Fragment>
                <TransitionGroup>
                    <CSSTransition component="div" classNames="TabsAnimation" appear={true}
                        timeout={1500} enter={false} exit={false}>
                        <div>    
                            <PageTitle  heading="Dropdowns"
                                subheading="Multiple styles, actions and effects are available for the ArchitectUI dropdown buttons."
                                icon="pe-7s-umbrella icon-gradient bg-sunny-morning"/>
                            <div className="tabs-animation-wrap">
                                <Tabs>
                                    <TabList className="nav nav-tabs">
                                        <Tab className="nav-item">
                                            <span className="nav-link">Advanced Menus</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Regular Dropdowns</span>
                                        </Tab>
                                    </TabList>
                                    <TabPanel>
                                        <DropdownGridMenus />
                                    </TabPanel>
                                    <TabPanel>
                                        <DropdownStyles />
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
