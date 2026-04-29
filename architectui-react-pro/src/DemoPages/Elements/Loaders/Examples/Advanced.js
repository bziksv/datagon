import React, { Component, Fragment } from "react";
import { CSSTransition, TransitionGroup } from "../../../../components/React19Transition";
import { Audio, Oval, ThreeDots, TailSpin } from "react-loader-spinner";

import { Button } from "reactstrap";

const contentBoxStyle = {
  backgroundColor: "white",
  position: "relative",
  padding: 20,
  border: "1px solid lightgrey",
  borderRadius: "5px",
};

// Custom LoadingOverlay component using react-loader-spinner
const LoadingOverlay = ({ active, spinner, children, ...props }) => {
  if (!active) {
    return children;
  }

  return (
    <div style={{ position: "relative" }}>
      <div style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: "rgba(255, 255, 255, 0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000
      }}>
        {spinner}
      </div>
      <div style={{ opacity: active ? 0.3 : 1 }}>
        {children}
      </div>
    </div>
  );
};

class LoadersAdvancedExample extends Component {
  state = {
    loader1: false,
    loader2: false,
    loader3: false,
    loader4: false,
  };

  UNSAFE_componentWillMount() {
    this.load();
  }

  load = () => {
    this.setState({
      loader1: true,
      loader2: true,
      loader3: true,
      loader4: true,
    });

    setTimeout(() => this.setState({ loader1: false }), 1500);
    setTimeout(() => this.setState({ loader2: false }), 2000);
    setTimeout(() => this.setState({ loader3: false }), 2500);
    setTimeout(() => this.setState({ loader4: false }), 3000);
  };

  render() {
    return (
      <Fragment>
        <TransitionGroup>
          <CSSTransition component="div" classNames="TabsAnimation" appear={true}
            timeout={0} enter={false} exit={false}>
            <div className="row">
                <div className="col-lg-6">
                  <div className="card-header">
                    <div className="card-header-title font-size-lg text-capitalize font-weight-normal">
                      Audio Loader
                    </div>
                  </div>
                  <div className="card-body">
                    <LoadingOverlay
                      active={this.state.loader1}
                      spinner={<Audio height="80" width="80" color="#007bff" />}
                    >
                      <div style={contentBoxStyle}>
                        <h3>Some Content</h3>
                        <div>
                          Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut
                          labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco
                          laboris nisi ut aliquip ex ea commodo consequat.
                        </div>
                      </div>
                    </LoadingOverlay>
                  </div>
                </div>
                <div className="col-lg-6">
                  <div className="card-header">
                    <div className="card-header-title font-size-lg text-capitalize font-weight-normal">
                      Oval Loader
                    </div>
                  </div>
                  <div className="card-body">
                    <LoadingOverlay
                      active={this.state.loader2}
                      spinner={<Oval height="80" width="80" color="#007bff" />}
                    >
                      <div style={contentBoxStyle}>
                        <h3>Some Content</h3>
                        <div>
                          Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut
                          labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco
                          laboris nisi ut aliquip ex ea commodo consequat.
                        </div>
                      </div>
                    </LoadingOverlay>
                  </div>
                </div>
              </div>
              <div className="row">
                <div className="col-lg-6">
                  <div className="card-header">
                    <div className="card-header-title font-size-lg text-capitalize font-weight-normal">
                      Three Dots Loader
                    </div>
                  </div>
                  <div className="card-body">
                    <LoadingOverlay
                      active={this.state.loader3}
                      spinner={<ThreeDots height="80" width="80" color="#007bff" />}
                    >
                      <div style={contentBoxStyle}>
                        <h3>Some Content</h3>
                        <div>
                          Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut
                          labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco
                          laboris nisi ut aliquip ex ea commodo consequat.
                        </div>
                      </div>
                    </LoadingOverlay>
                  </div>
                </div>
                <div className="col-lg-6">
                  <div className="card-header">
                    <div className="card-header-title font-size-lg text-capitalize font-weight-normal">
                      Tail Spin Loader
                    </div>
                  </div>
                  <div className="card-body">
                    <LoadingOverlay
                      active={this.state.loader4}
                      spinner={<TailSpin height="80" width="80" color="#007bff" />}
                    >
                      <div style={contentBoxStyle}>
                        <h3>Some Content</h3>
                        <div>
                          Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut
                          labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco
                          laboris nisi ut aliquip ex ea commodo consequat.
                        </div>
                      </div>
                    </LoadingOverlay>
                  </div>
                </div>
              </div>
              <div className="text-center">
                <Button size="lg" color="primary" onClick={this.load}>
                  Reload Loaders
                </Button>
              </div>
          </CSSTransition>
        </TransitionGroup>
      </Fragment>
    );
  }
}

export default LoadersAdvancedExample;
