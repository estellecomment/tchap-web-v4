/**
 * Copyright DINUM 2023
 */

import React from "react";

import { FileDownloader } from "matrix-react-sdk/src/utils/FileDownloader";
import AccessibleTooltipButton from "matrix-react-sdk/src/components/views/elements/AccessibleTooltipButton";
import { ButtonEvent } from "matrix-react-sdk/src/components/views/elements/AccessibleButton";
import { Room } from "matrix-js-sdk/src/models/room";
import { _t } from "matrix-react-sdk/src/languageHandler";

import "../../../../../res/css/views/rooms/TchapExportMembersButton.pcss";

interface IProps {
  room: Room;
  roomMembersIds: Array<string>;
}

interface IState {
}

export default class MemberList extends React.Component<IProps, IState> {
  private downloader = new FileDownloader();

  public constructor(props: IProps) {
    super(props);
  }

  private onExportButtonClick = (ev: ButtonEvent): void => {
    const blob = new Blob([this.props.roomMembersIds.join()], { type : 'plain/text' })

    const filename = _t('members_of_%(roomName)s.txt', {
        roomName: this.props.room.normalizedName,
    });

    this.downloader.download({
        blob: blob,
        name: filename,
    });

    return;
  };

  public render(): React.ReactNode {
    if (this.props.room?.getMyMembership() === "join" && !this.props.room.isSpaceRoom() && this.props.roomMembersIds.length > 0) {
      return (
          <AccessibleTooltipButton
              data-testid="tc_exportRoomMembersButton"
              className="tc_MemberList_export mx_AccessibleButton mx_AccessibleButton_hasKind mx_AccessibleButton_kind_primary_outline"
              onClick={this.onExportButtonClick}
              tooltip={_t("Download the list of all this room's members, in a text file. Useful for adding them all to another room.")}
              tooltipClassName="tc_exportRoomMembersTooltip"
          >
              <span>{_t("Export room members")}</span>
          </AccessibleTooltipButton>
      );
    }
    return null;
  }

}