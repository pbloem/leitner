String.prototype.hash = function() {
    var hash = 0, i = 0, len = this.length;
    while ( i < len ) {
        hash  = ((hash << 5) - hash + this.charCodeAt(i++)) << 0;
    }
    return hash;
};

var lt = { // * top-level namespace
	
	init : function() 
	{
		let request = window.indexedDB.open('leitner', 1);
		
		request.onerror   = function() {
			console.log('Database failed to open'); 
		};
		
		request.onsuccess = function() {
			console.log('Database opened successfully'); 
			lt.db = request.result;
		};

		// Setup the database tables if this has not already been done
		request.onupgradeneeded = function(e) 
		{
			let db = e.target.result;

			// table for card-answering events
			let store = db.createObjectStore('events', { keyPath: 'id', autoIncrement:true });

			// -- timestamp of the answering event
			store.createIndex('timestamp', 'timestamp', { unique: false });
			
			// -- target card (the correct answer in the case of MC)
			store.createIndex('card', 'card', { unique: false });
		
			// -- alternative 1 (in MC questions)
			store.createIndex('alt1', 'alt1', { unique: false });
			
			// -- alternative 2 (in MC questions)
  			store.createIndex('alt2', 'alt2', { unique: false });
  			
  			// -- result of the answering event (positive for correct, negative for incorrect)
			store.createIndex('result', 'result', { unique: false });

			console.log('Database setup complete.');
		};
	},
	
	templates : { mc: $.templates("#mc") },
	
	sounds: {
		correct: new Audio('/sounds/correct.mp3'),
		incorrect: new Audio('/sounds/incorrect.wav')
	},
	
	decks : {},
	
	/**
	 * Takes a dictionary representing a deck, enriches it, and adds it to the set of 
	 * decks in the namespace.
	 */
	loadDeck : function(deck) 
	{
		deck.cards.forEach((card) => 
		{		
			// - generate (sufficiently) unique IDs for cards that don't
			//   have them
			if (!( 'id' in card))
				card.id = (card.f + card.b + '').hash()		
		});
		
		lt.decks[deck.name] = deck
		
		console.log(deck.name + ' loaded')
	},

	
	// * sub-namespace for the current session
	session : {
	
		startSession : function(deck)
		{

			lt.session.deck = deck
			lt.session.generate();
		},
	
		generate : function() 
		{
			let deck = lt.session.deck
			$("article").empty();

			// generate a question
			// -- sample three cards. The first is the target, the other two provide false answers
			sample = _.sampleSize(deck.cards, 3);
			corr = _.sample([0, 1, 2]);

			q = sample[corr].sides[0];

			$("article").html(
				lt.templates.mc.render({
					question: q,
					answer0: sample[0].sides[2],
					answer1: sample[1].sides[2],
					answer2: sample[2].sides[2]
				})
			)

			if (q.length < 4)
				$(".frame .question").addClass("short")
			else if (q.length < 10)
				$(".frame .question").addClass("medium")
			
			$("article .frame button").on(
				'click',
				{ 
			      timestamp: Date.now(),
				  card: sample[0].id,
				  alt1: sample[1].id,
				  alt2: sample[2].id,
 				  correct: corr
				},
				lt.session.processAnswer
			)            
		},
	
		processAnswer : function(e)
		{
			answered = $(e.target).data('answer')
			correct = e.data.correct
			
			// * write event to db
			let trs = lt.db.transaction(["events"], "readwrite");
			trs.oncomplete = function(e){console.log('Event stored')};
			trs.onerror = function(e){console.log(e)};
			
			let events = trs.objectStore("events");
			let rq = events.add(e.data)

			if(answered == correct)
			{
// 				$('article').append('Correct!');
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
			
				setTimeout(lt.session.generate , 750)
			} else
			{
// 				$('article').append('Incorrect!');
				lt.sounds.incorrect.play()
			}
		},
	}
}

$(function() {

	// - init database
	lt.init();

	// - load decks
	$.getJSON('./deck.json', lt.loadDeck)	
	.done(function(){
		lt.session.startSession(lt.decks['Hanzi'])
	});

;});