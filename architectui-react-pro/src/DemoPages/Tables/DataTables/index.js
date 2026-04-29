import React, { Fragment } from 'react';
import { CSSTransition, TransitionGroup } from "../../../components/React19Transition";
import { Tabs, TabList, Tab, TabPanel } from 'react-tabs';

import PageTitle from '../../../Layout/AppMain/PageTitle';

import DataTableBasic from './Examples/Basic';
import DataTableFixedHeader from './Examples/FixedHeader';
import DataTablePivoting from './Examples/Pivoting';
import DataTableCustomComps from './Examples/CustomComps';
import DataTableEditable from './Examples/EditableTable';

const DataTables = () => {
    return (
        <Fragment>
            <TransitionGroup>
                <CSSTransition component="div" classNames="TabsAnimation" appear={true}
                    timeout={1500} enter={false} exit={false}>
                    <div>
                        <PageTitle
                            heading="Data Tables"
                            subheading="Advanced data tables with sorting, filtering, and pagination capabilities."
                            icon="pe-7s-server icon-gradient bg-happy-itmeo"
                        />
                        <div className="tabs-animation-wrap">
                            <Tabs>
                                <TabList className="nav nav-tabs">
                                    <Tab className="nav-item">
                                        <span className="nav-link">Basic</span>
                                    </Tab>
                                    <Tab className="nav-item">
                                        <span className="nav-link">Fixed Header</span>
                                    </Tab>
                                    <Tab className="nav-item">
                                        <span className="nav-link">Selectable Rows</span>
                                    </Tab>
                                    <Tab className="nav-item">
                                        <span className="nav-link">Custom Components</span>
                                    </Tab>
                                    <Tab className="nav-item">
                                        <span className="nav-link">Editable</span>
                                    </Tab>
                                </TabList>
                                <TabPanel>
                                    <DataTableBasic />
                                </TabPanel>
                                <TabPanel>
                                    <DataTableFixedHeader />
                                </TabPanel>
                                <TabPanel>
                                    <DataTablePivoting />
                                </TabPanel>
                                <TabPanel>
                                    <DataTableCustomComps />
                                </TabPanel>
                                <TabPanel>
                                    <DataTableEditable />
                                </TabPanel>
                            </Tabs>
                        </div>
                    </div>
                </CSSTransition>
            </TransitionGroup>
        </Fragment>
    );
};

export default DataTables; 