import React from "react";

const DatagonCard = ({ title, children, hint, actions = null }) => (
  <div className="main-card mb-3 card">
    <div className="card-header d-flex align-items-center justify-content-between gap-2">
      <div className="d-flex align-items-center">
        <i className="header-icon pe-7s-note2 icon-gradient bg-happy-fisher me-2"> </i>
        <span>{title}</span>
      </div>
      {actions ? <div className="d-flex align-items-center">{actions}</div> : null}
    </div>
    <div className="card-body">
      {children}
      {hint ? <p className="text-muted mb-0 mt-2">{hint}</p> : null}
    </div>
  </div>
);

export default DatagonCard;
