import React, { Fragment } from 'react';
import { CSSTransition, TransitionGroup } from "../../../../components/React19Transition";
import { Tabs, TabList, Tab, TabPanel } from 'react-tabs';

import PageTitle from '../../../../Layout/AppMain/PageTitle';

// Examples
import FormDropdownExample from './Examples/Dropdown/';
import FormComboboxExample from './Examples/Combobox/';

class FormDropdown extends React.Component {
    render() {
        return (
            <Fragment>
                <TransitionGroup>
                    <CSSTransition component="div" classNames="TabsAnimation" appear={true}
                        timeout={1500} enter={false} exit={false}>
                        <div>    
                            <PageTitle
                                heading="Form Dropdowns"
                                subheading="Widgets that help you build good looking react dropdown menus, easily."
                                icon="pe-7s-volume1 icon-gradient bg-plum-plate"
                            />
                            <div className="tabs-animation-wrap">
                                <Tabs>
                                    <TabList className="nav nav-tabs">
                                        <Tab className="nav-item">
                                            <span className="nav-link">Dropdown</span>
                                        </Tab>
                                        <Tab className="nav-item">
                                            <span className="nav-link">Combobox</span>
                                        </Tab>
                                    </TabList>
                                    <TabPanel>
                                        <FormDropdownExample />
                                    </TabPanel>
                                    <TabPanel>
                                        <FormComboboxExample />
                                    </TabPanel>
                                </Tabs>
                            </div>
                        </div>
                    </CSSTransition>
                </TransitionGroup>
            </Fragment>
        )
    }
}

export default FormDropdown;