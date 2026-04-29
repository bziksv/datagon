import React, { Fragment } from 'react';
import AppHeader from './AppHeader';
import AppSidebar from './AppSidebar';
import AppFooter from './AppFooter';

const AppLayout = ({ children }) => {
  return (
    <Fragment>
      <AppHeader />
      <div className="app-main">
        <AppSidebar />
        <div className="app-main__outer">
          <div className="app-main__inner">
            {children}
          </div>
          <AppFooter />
        </div>
      </div>
    </Fragment>
  );
};

export default AppLayout; 