/// <reference types="cypress" />

import RoomUtils from "../utils/room-utils";
import Chainable = Cypress.Chainable;



describe("Check room access settings", () => {
    const homeserverUrl = Cypress.env('E2E_TEST_USER_HOMESERVER_URL');
    const email = Cypress.env('E2E_TEST_USER_EMAIL');
    const password = Cypress.env('E2E_TEST_USER_PASSWORD');
    const homeserverShortname = Cypress.env('E2E_TEST_USER_HOMESERVER_SHORT');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    beforeEach(() => {
        cy.loginUser(homeserverUrl, email, password);
    });

    afterEach(() => {
        // todo logout, otherwise the login test is not reliable aby more.
        // todo delete room, otherwise the test user will end up with a million identical rooms after a while.
    });

    it("creates a public room and check access settings", () => {
      const roomName = "test/"+today+"/public_room_check_access_settings";

      RoomUtils.createPublicRoom(roomName);

      openRoomAccessSettings();

        //assert
        cy.get('#joinRule-invite-description').should('not.exist');
        cy.get('#joinRule-restricted-description').should('not.exist');
        cy.get('#joinRule-public-description').should('exist');
    });

    it("creates a private room and check access settings", () => {
      const roomName = "test/"+today+"/private_room_check_access_settings";

      RoomUtils.createPrivateRoom(roomName);

      openRoomAccessSettings();

      //assert
      cy.get('#joinRule-invite-description').should('exist');
      cy.get('#joinRule-restricted-description').should('not.exist');
      cy.get('#joinRule-public-description').should('not.exist');
    });

    it("creates a private room with external and check access settings", () => {
      const roomName = "test/"+today+"/private_room_check_access_settings";

      RoomUtils.createPrivateRoomWithExternal(roomName);

      openRoomAccessSettings();

      //assert
      cy.get('#joinRule-invite-description').should('exist');
      cy.get('#joinRule-restricted-description').should('not.exist');
      cy.get('#joinRule-public-description').should('not.exist');
    });
});


function openRoomAccessSettings(){
  cy.get('.mx_RoomHeader_chevron').click();
  cy.get('[aria-label="Paramètres"] > .mx_IconizedContextMenu_label').click();
  cy.get('[data-testid="settings-tab-ROOM_SECURITY_TAB"] > .mx_TabbedView_tabLabel_text').click();
}
