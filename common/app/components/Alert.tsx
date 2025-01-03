import React, { useEffect } from 'react';
import { makeStyles } from '@material-ui/core/styles';
import MuiAlert, { Color } from '@material-ui/lab/Alert';
import Grow from '@material-ui/core/Grow';

const useAlertStyles = makeStyles({
    root: {
        display: 'flex',
        justifyContent: 'center',
        position: 'fixed',
        top: '10vh',
        width: '100%',
        pointerEvents: 'none',
        zIndex: 2000,
    },
});

interface Props {
    open: boolean;
    autoHideDuration: number;
    onClose: () => void;
    severity: Color | undefined;
    disableAutoHide: boolean;
    children: React.ReactNode;
}

export default function Alert(props: Props) {
    const classes = useAlertStyles();

    useEffect(() => {
        if (props.open && !props.disableAutoHide) {
            const timeout = setTimeout(props.onClose, props.autoHideDuration);
            return () => clearTimeout(timeout);
        }
    }, [props.open, props.autoHideDuration, props.disableAutoHide, props.onClose]);

    return (
        <div className={classes.root}>
            <Grow in={props.open}>
                <MuiAlert severity={props.severity}>{props.children}</MuiAlert>
            </Grow>
        </div>
    );
}
