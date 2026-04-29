import React, {Fragment} from 'react';
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";
import { Tabs, TabList, Tab, TabPanel } from 'react-tabs';
import 'react-tabs/style/react-tabs.css';

import PageTitle from '../../../Layout/AppMain/PageTitle';

// Examples
import TimelineDotBadge from './Examples/DotBadge';
import TimelineIconBadge from './Examples/IconBadge';
import TimelineScrollable from './Examples/ScrollableTimeline';

export default class TimelineExample extends React.Component {

    render() {

        return (
            <Fragment>
                <TransitionGroup>
                    <CSSTransition component="div" classNames="TabsAnimation" appear={true}
                        timeout={1500} enter={false} exit={false}>
                        <div>    
                            <PageTitle heading="Timelines"
                                subheading="Timelines are used to show lists of notifications, tasks or actions in a beautiful way."
                                icon="pe-7s-light icon-gradient bg-malibu-beach"/>
                            <div className="tabs-animation-wrap">
                                <Tabs>
                                    <TabList className="nav nav-tabs">
                                        <Tab className="nav-item">
                                            <span className="nav-link">Dot Badges</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Icon Badges</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Scrollable Timelines</span>
                                        </Tab>
                                    </TabList>
                                    <TabPanel>
                                        <TimelineDotBadge />
                                    </TabPanel>
                                    <TabPanel>
                                        <TimelineIconBadge />
                                    </TabPanel>
                                    <TabPanel>
                                        <TimelineScrollable />
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
