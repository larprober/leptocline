import QtQuick 2.0;
import calamares.slideshow 1.0;

Presentation {
    id: presentation

    Timer { interval: 6000; running: true; repeat: true; onTriggered: presentation.goToNextSlide() }

    Slide {
        Rectangle {
            anchors.fill: parent
            color: "#0B2024"
            Text {
                anchors.centerIn: parent
                horizontalAlignment: Text.AlignHCenter
                color: "#FFFFFF"
                font.pixelSize: 24
                text: "Linux Leptocline\n\nA Debian-based system with a security toolkit,\ninstalling now."
            }
        }
    }
}
