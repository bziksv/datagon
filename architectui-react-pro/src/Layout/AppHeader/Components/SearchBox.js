import React, { Fragment } from "react";

import cx from "classnames";

class SearchBox extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      activeSearch: false,
    };
  }

  getDocsBaseUrl = () => {
    const { protocol, hostname, port } = window.location;
    // In local dev frontend runs on :3003, while backend serves /docs on :3000.
    if ((hostname === "localhost" || hostname === "127.0.0.1") && port === "3003") {
      return `${protocol}//${hostname}:3000/docs/`;
    }
    return `${protocol}//${window.location.host}/docs/`;
  };

  openDocs = () => {
    const input = document.querySelector(".search-input");
    const query = String(input?.value || "").trim();
    const base = this.getDocsBaseUrl();
    const target = query
      ? `${base}search?q=${encodeURIComponent(query)}`
      : base;
    window.location.assign(target);
  };

  render() {
    return (
      <Fragment>
        <div className={cx("search-wrapper", {
            active: this.state.activeSearch,
          })}>
          <div className="input-holder">
            <input type="text" className="search-input" placeholder="Type to search"/>
            <button
              type="button"
              onClick={() => this.openDocs()}
              className="search-icon"
              aria-label="Открыть документацию"
              title="Документация">
              <span />
            </button>
          </div>
          <button onClick={() =>
              this.setState({ activeSearch: !this.state.activeSearch })
            }
            className="btn-close"/>
        </div>
      </Fragment>
    );
  }
}

export default SearchBox;
