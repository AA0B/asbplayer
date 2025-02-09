import React, { useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { useTranslation } from 'react-i18next';
import Box from '@material-ui/core/Box';
import Dialog from '@material-ui/core/Dialog';
import DialogContent from '@material-ui/core/DialogContent';
import ChromeExtension from '../services/chrome-extension';
import SettingsForm from '../../components/SettingsForm';
import { useLocalFontFamilies } from '../../hooks';
import { Anki } from '../../anki';
import { AsbplayerSettings, Profile, supportedLanguages } from '../../settings';
import SettingsProfileSelectMenu from '../../components/SettingsProfileSelectMenu';
import Toolbar from '@material-ui/core/Toolbar';
import Typography from '@material-ui/core/Typography';
import IconButton from '@material-ui/core/IconButton';
import CloseIcon from '@material-ui/icons/Close';

const useStyles = makeStyles((theme) => ({
    root: {
        '& .MuiPaper-root': {
            height: '100vh',
        },
    },
    content: {
        maxHeight: '100%',
    },
    profilesContainer: {
        paddingLeft: theme.spacing(4),
        paddingRight: theme.spacing(4),
        paddingBottom: theme.spacing(2),
    },
    title: {
        flexGrow: 1,
    },
}));

interface Props {
    anki: Anki;
    extension: ChromeExtension;
    open: boolean;
    settings: AsbplayerSettings;
    scrollToId?: string;
    onSettingsChanged: (settings: Partial<AsbplayerSettings>) => void;
    onClose: () => void;
    profiles: Profile[];
    activeProfile?: string;
    onNewProfile: (name: string) => void;
    onRemoveProfile: (name: string) => void;
    onSetActiveProfile: (name: string | undefined) => void;
}

export default function SettingsDialog({
    anki,
    extension,
    open,
    settings,
    scrollToId,
    onSettingsChanged,
    onClose,
    ...profilesContext
}: Props) {
    const { t } = useTranslation();
    const classes = useStyles();

    const {
        updateLocalFontsPermission,
        updateLocalFonts,
        localFontsAvailable,
        localFontsPermission,
        localFontFamilies,
    } = useLocalFontFamilies();
    const handleUnlockLocalFonts = useCallback(() => {
        updateLocalFontsPermission();
        updateLocalFonts();
    }, [updateLocalFontsPermission, updateLocalFonts]);

    return (
        <Dialog open={open} maxWidth="md" fullWidth className={classes.root} onClose={onClose}>
            <Toolbar>
                <Typography variant="h6" className={classes.title}>
                    {t('settings.title')}
                </Typography>
                <IconButton edge="end" onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </Toolbar>
            <DialogContent className={classes.content}>
                <SettingsForm
                    anki={anki}
                    extensionInstalled={extension.installed}
                    extensionVersion={extension.installed ? extension.version : undefined}
                    extensionSupportsAppIntegration={extension.supportsAppIntegration}
                    extensionSupportsOverlay={extension.supportsStreamingVideoOverlay}
                    extensionSupportsSidePanel={extension.supportsSidePanel}
                    extensionSupportsOrderableAnkiFields={extension.supportsOrderableAnkiFields}
                    extensionSupportsTrackSpecificSettings={extension.supportsTrackSpecificSettings}
                    extensionSupportsSubtitlesWidthSetting={extension.supportsSubtitlesWidthSetting}
                    extensionSupportsPauseOnHover={extension.supportsPauseOnHover}
                    insideApp
                    appVersion={import.meta.env.VITE_APP_GIT_COMMIT}
                    chromeKeyBinds={extension.extensionCommands}
                    onOpenChromeExtensionShortcuts={extension.openShortcuts}
                    onSettingsChanged={onSettingsChanged}
                    settings={settings}
                    scrollToId={scrollToId}
                    localFontsAvailable={localFontsAvailable}
                    localFontsPermission={localFontsPermission}
                    localFontFamilies={localFontFamilies}
                    supportedLanguages={supportedLanguages}
                    onUnlockLocalFonts={handleUnlockLocalFonts}
                />
            </DialogContent>
            {(!extension.installed || extension.supportsSettingsProfiles) && (
                <Box className={classes.profilesContainer}>
                    <SettingsProfileSelectMenu {...profilesContext} />
                </Box>
            )}
        </Dialog>
    );
}
