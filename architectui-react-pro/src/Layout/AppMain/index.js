import { Route, Routes, Navigate, useLocation } from "react-router-dom";
import React, { Suspense, lazy, Fragment, useState, useEffect } from "react";
import { TailSpin, Rings, Puff, Grid, Hearts } from "react-loader-spinner";

import { ToastContainer } from "react-toastify";
import "./LoadingScreen.css";

import AppLayout from "../AppLayout";
import DatagonColumnsManager from "../../components/DatagonColumnsManager";

const UserPages = lazy(() => import("../../DemoPages/UserPages"));
const Applications = lazy(() => import("../../DemoPages/Applications"));
const Dashboards = lazy(() => import("../../DemoPages/Dashboards"));

const Widgets = lazy(() => import("../../DemoPages/Widgets"));
const Elements = lazy(() => import("../../DemoPages/Elements"));
const Components = lazy(() => import("../../DemoPages/Components"));
const Charts = lazy(() => import("../../DemoPages/Charts"));
const Forms = lazy(() => import("../../DemoPages/Forms"));
const Tables = lazy(() => import("../../DemoPages/Tables"));
const DatagonDashboardPage = lazy(() => import("../../DatagonPages/DashboardPage"));
const DatagonMyProductsPage = lazy(() => import("../../DatagonPages/MyProductsPage"));
const DatagonMoyskladPage = lazy(() => import("../../DatagonPages/MoyskladPage"));
const DatagonMatchesPage = lazy(() => import("../../DatagonPages/MatchesPage"));
const DatagonResultsPage = lazy(() => import("../../DatagonPages/ResultsPage"));
const DatagonQueuePage = lazy(() => import("../../DatagonPages/QueuePage"));
const DatagonMySitesPage = lazy(() => import("../../DatagonPages/MySitesPage"));
const DatagonSettingsPage = lazy(() => import("../../DatagonPages/SettingsPage"));
const DatagonProjectsPage = lazy(() => import("../../DatagonPages/ProjectsPage"));
const DatagonProcessesPage = lazy(() => import("../../DatagonPages/ProcessesPage"));

/** Старые закладки вида /datagon/my-products → /my-products */
const LegacyDatagonRedirect = () => {
  const location = useLocation();
  let path = location.pathname.replace(/^\/datagon(\/|$)/, "/");
  if (path === "/" || path === "") path = "/dashboard";
  return <Navigate to={`${path}${location.search}${location.hash}`} replace />;
};

// Simple CSS-based loader component using existing classes
const CSSLoader = () => (
  <div className="css-loader-container">
    <div className="loader ball-pulse">
      <div></div>
      <div></div>
      <div></div>
    </div>
  </div>
);

// Beautiful loading screen component with multiple animation options
const LoadingSpinner = () => {
  const [currentLoader, setCurrentLoader] = useState(0);
  const [fadeClass, setFadeClass] = useState('fade-in');
  
  // Array of beautiful loaders to cycle through
  const loaders = [
    { 
      component: <TailSpin height="60" width="60" color="#474bff" />, 
      name: "TailSpin",
      color: "#474bff"
    },
    { 
      component: <Rings height="60" width="60" color="#17a2b8" />, 
      name: "Rings",
      color: "#17a2b8"
    },
    { 
      component: <Puff height="60" width="60" color="#28a745" />, 
      name: "Puff",
      color: "#28a745"
    },
    { 
      component: <Grid height="60" width="60" color="#fd7e14" />, 
      name: "Grid",
      color: "#fd7e14"
    },
    { 
      component: <Hearts height="60" width="60" color="#e83e8c" />, 
      name: "Hearts",
      color: "#e83e8c"
    },
    { 
      component: <CSSLoader />, 
      name: "Ball Pulse",
      color: "#6f42c1"
    }
  ];

  // Cycle through different loaders every 2 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setFadeClass('fade-out');
      setTimeout(() => {
        setCurrentLoader((prev) => (prev + 1) % loaders.length);
        setFadeClass('fade-in');
      }, 300);
    }, 2000);

    return () => clearInterval(interval);
  }, [loaders.length]);

  const currentLoaderData = loaders[currentLoader];

  return (
    <div className="beautiful-loader-container">
      <div className="beautiful-loader-content">
        <div className="beautiful-logo-pulse">
          <h1 className="beautiful-loader-title">Датагон</h1>
        </div>
        
        <p className="beautiful-loader-subtitle">Панель управления проектами</p>
        
        <div className={`beautiful-loader-animation ${fadeClass}`}>
          {currentLoaderData.component}
        </div>
        
        <div className="beautiful-loader-progress">
          <div className="beautiful-loader-progress-bar"></div>
        </div>
        
        <div className="beautiful-loader-status">
          Загружаем панель управления<span className="beautiful-loader-dots">...</span>
        </div>
      </div>
    </div>
  );
};

const AppMain = () => {
  const location = useLocation();

  useEffect(() => {
    const titleByPath = new Map([
      ["/dashboard", "Дашборд"],
      ["/my-sites", "Мои сайты"],
      ["/my-products", "Мои товары"],
      ["/moysklad", "МойСклад"],
      ["/matches", "Сопоставление"],
      ["/matching", "Сопоставление"],
      ["/queue", "Очередь"],
      ["/results", "Результаты"],
      ["/projects", "Конкуренты"],
      ["/processes", "Логи и процессы"],
      ["/settings", "Настройки"],
    ]);

    const path = String(location.pathname || "");
    const pageTitle = titleByPath.get(path) || "Датагон";
    document.title = `${pageTitle} - Датагон`;
  }, [location.pathname]);

  return (
    <Fragment>
      <DatagonColumnsManager />
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="/datagon/*" element={<LegacyDatagonRedirect />} />

          <Route path="/" element={<Navigate to="/dashboard" replace />} />

          <Route path="/dashboard" element={
            <AppLayout>
              <DatagonDashboardPage />
            </AppLayout>
          } />

          <Route path="/my-products" element={
            <AppLayout>
              <DatagonMyProductsPage />
            </AppLayout>
          } />

          <Route path="/moysklad" element={
            <AppLayout>
              <DatagonMoyskladPage />
            </AppLayout>
          } />

          <Route path="/matches" element={
            <AppLayout>
              <DatagonMatchesPage />
            </AppLayout>
          } />

          <Route path="/matching" element={
            <AppLayout>
              <DatagonMatchesPage />
            </AppLayout>
          } />

          <Route path="/results" element={
            <AppLayout>
              <DatagonResultsPage />
            </AppLayout>
          } />

          <Route path="/queue" element={
            <AppLayout>
              <DatagonQueuePage />
            </AppLayout>
          } />

          <Route path="/my-sites" element={
            <AppLayout>
              <DatagonMySitesPage />
            </AppLayout>
          } />

          <Route path="/settings" element={
            <AppLayout>
              <DatagonSettingsPage />
            </AppLayout>
          } />

          <Route path="/projects" element={
            <AppLayout>
              <DatagonProjectsPage />
            </AppLayout>
          } />

          <Route path="/processes" element={
            <AppLayout>
              <DatagonProcessesPage />
            </AppLayout>
          } />
          
          {/* Main application routes - each section gets its own top-level route */}
          <Route path="/dashboards/*" element={
            <AppLayout>
              <Dashboards />
            </AppLayout>
          } />
          
          <Route path="/elements/*" element={
            <AppLayout>
              <Elements />
            </AppLayout>
          } />
          
          <Route path="/components/*" element={
            <AppLayout>
              <Components />
            </AppLayout>
          } />
          
          <Route path="/forms/*" element={
            <AppLayout>
              <Forms />
            </AppLayout>
          } />
          
          <Route path="/charts/*" element={
            <AppLayout>
              <Charts />
            </AppLayout>
          } />
          
          <Route path="/tables/*" element={
            <AppLayout>
              <Tables />
            </AppLayout>
          } />
          
          <Route path="/widgets/*" element={
            <AppLayout>
              <Widgets />
            </AppLayout>
          } />
          
          <Route path="/apps/*" element={
            <AppLayout>
              <Applications />
            </AppLayout>
          } />
          
          {/* User Pages without layout */}
          <Route path="/pages/*" element={<UserPages />} />
        </Routes>
      </Suspense>

      <ToastContainer
        position="top-right"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
      />
    </Fragment>
  );
};

export default AppMain;
