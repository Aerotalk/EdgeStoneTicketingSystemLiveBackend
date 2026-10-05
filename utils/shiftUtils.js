/**
 * Shift Utility for EdgeStone Ticketing System
 * Operating Shifts:
 * - Shift A: Morning   (06:00 - 14:00 IST)
 * - Shift B: Afternoon (14:00 - 22:00 IST)
 * - Shift C: Night     (22:00 - 06:00 IST, crosses midnight)
 */

const SHIFT_CONFIG = {
    A: { name: 'Morning', timeRange: '06:00 - 14:00 IST', icon: 'Sun' },
    B: { name: 'Afternoon', timeRange: '14:00 - 22:00 IST', icon: 'CloudSun' },
    C: { name: 'Night', timeRange: '22:00 - 06:00 IST', icon: 'Moon' }
};

/**
 * Returns current IST date and time components
 */
const getISTComponents = (targetDate = new Date()) => {
    // en-CA gives YYYY-MM-DD format directly in target timezone
    const formatterDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    const formatterTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const dateParts = formatterDate.format(targetDate); // "YYYY-MM-DD"
    const timeParts = formatterTime.format(targetDate); // "HH:mm:ss"
    const [hours, minutes] = timeParts.split(':').map(Number);
    const decimalHours = hours + (minutes / 60);

    return {
        istDateStr: dateParts,
        hours,
        minutes,
        decimalHours
    };
};

/**
 * Determines the operational date and shift for a given timestamp
 */
const resolveShiftInfo = (targetDate = new Date()) => {
    const { istDateStr, decimalHours } = getISTComponents(targetDate);

    let shift = 'A';
    let shiftName = 'Morning';
    let timeRange = '06:00 - 14:00 IST';
    let [yyyy, mm, dd] = istDateStr.split('-').map(Number);
    let operationalDate = new Date(Date.UTC(yyyy, mm - 1, dd));

    if (decimalHours >= 6 && decimalHours < 14) {
        shift = 'A';
        shiftName = SHIFT_CONFIG.A.name;
        timeRange = SHIFT_CONFIG.A.timeRange;
    } else if (decimalHours >= 14 && decimalHours < 22) {
        shift = 'B';
        shiftName = SHIFT_CONFIG.B.name;
        timeRange = SHIFT_CONFIG.B.timeRange;
    } else {
        shift = 'C';
        shiftName = SHIFT_CONFIG.C.name;
        timeRange = SHIFT_CONFIG.C.timeRange;

        // If between 00:00 and 05:59 IST, it is the continuation of yesterday's night shift
        if (decimalHours < 6) {
            operationalDate.setUTCDate(operationalDate.getUTCDate() - 1);
        }
    }

    const opYear = operationalDate.getUTCFullYear();
    const opMonth = String(operationalDate.getUTCMonth() + 1).padStart(2, '0');
    const opDay = String(operationalDate.getUTCDate()).padStart(2, '0');
    const resolvedDateStr = `${opYear}-${opMonth}-${opDay}`;

    return {
        date: resolvedDateStr,
        shift,
        shiftName,
        timeRange,
        displayTitle: `${formatDateDisplay(resolvedDateStr)} – ${shift} Shift Handover`
    };
};

/**
 * Formats "YYYY-MM-DD" into "DD Month YYYY" (e.g., "01 October 2026")
 */
const formatDateDisplay = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return '';
    const [yyyy, mm, dd] = dateStr.split('-');
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthName = months[parseInt(mm, 10) - 1] || mm;
    return `${dd} ${monthName} ${yyyy}`;
};

/**
 * Returns previous chronological shift and date
 */
const getPreviousShift = (dateStr, currentShift) => {
    let [yyyy, mm, dd] = dateStr.split('-').map(Number);
    let dateObj = new Date(Date.UTC(yyyy, mm - 1, dd));

    if (currentShift === 'C') {
        return { date: dateStr, shift: 'B', shiftName: SHIFT_CONFIG.B.name };
    } else if (currentShift === 'B') {
        return { date: dateStr, shift: 'A', shiftName: SHIFT_CONFIG.A.name };
    } else {
        // Shift A's predecessor is previous day's Shift C
        dateObj.setUTCDate(dateObj.getUTCDate() - 1);
        const prevYear = dateObj.getUTCFullYear();
        const prevMonth = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const prevDay = String(dateObj.getUTCDate()).padStart(2, '0');
        return {
            date: `${prevYear}-${prevMonth}-${prevDay}`,
            shift: 'C',
            shiftName: SHIFT_CONFIG.C.name
        };
    }
};

/**
 * Returns next chronological shift and date
 */
const getNextShift = (dateStr, currentShift) => {
    let [yyyy, mm, dd] = dateStr.split('-').map(Number);
    let dateObj = new Date(Date.UTC(yyyy, mm - 1, dd));

    if (currentShift === 'A') {
        return { date: dateStr, shift: 'B', shiftName: SHIFT_CONFIG.B.name };
    } else if (currentShift === 'B') {
        return { date: dateStr, shift: 'C', shiftName: SHIFT_CONFIG.C.name };
    } else {
        // Shift C's successor is next day's Shift A
        dateObj.setUTCDate(dateObj.getUTCDate() + 1);
        const nextYear = dateObj.getUTCFullYear();
        const nextMonth = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const nextDay = String(dateObj.getUTCDate()).padStart(2, '0');
        return {
            date: `${nextYear}-${nextMonth}-${nextDay}`,
            shift: 'A',
            shiftName: SHIFT_CONFIG.A.name
        };
    }
};

module.exports = {
    SHIFT_CONFIG,
    resolveShiftInfo,
    formatDateDisplay,
    getPreviousShift,
    getNextShift
};
